#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import type { FinalStatus, FinalVerdict } from '../contracts/verdict.ts';
import { FinalVerdictSchema } from '../contracts/verdict.ts';
import { assertNever } from '../invariant.ts';
import { runBatch } from '../run-all/index.ts';
import { runScenario } from '../runner/index.ts';
import {
  checkScenario,
  fixExecutableBits,
  newScenario,
  ScaffoldError,
} from '../scaffold.ts';
import { DEFAULT_JOBS } from '../scheduler/index.ts';
import type { ShowMode } from './render.ts';
import { render } from './render.ts';
import { batchJson, isBatchDir, renderBatch } from './render-batch.ts';
import { resolveTarget, ShowError } from './resolve-target.ts';
import {
  resolveScenarioDir,
  scenarioDirFor,
  scenarioName,
} from './scenario.ts';

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

// Immediate child dir names of `root` that hold a story.md, sorted (mirrors
// `quorum list` / the run-all scenario discovery — only dirs can hold the file).
function scenarioNames(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'story.md')))
    .sort();
}

// Parse a CSV filter flag: undefined/empty -> undefined (no filter, = all);
// otherwise the trimmed, non-empty members (parity with the Python `if csv`).
function csvList(csv: string | undefined): string[] | undefined {
  if (csv === undefined || csv === '') {
    return undefined;
  }
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface RunOptions {
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly scenariosRoot: string;
}

interface ShowOptions {
  readonly quiet: boolean;
  readonly json: boolean;
  readonly color: boolean;
  readonly resultsRoot: string;
}

interface RunAllOptions {
  readonly codingAgents?: string;
  readonly scenarios?: string;
  readonly jobs: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  // commander sets `cursor` to false for --no-cursor (default true).
  readonly cursor: boolean;
  readonly tier?: string;
  readonly includeDrafts: boolean;
}

const program = new Command();
program.name('quorum').description('Behavioral eval runner (TypeScript)');

program
  .command('run')
  .argument(
    '<scenario>',
    'scenario dir or name (a bare name resolves under --scenarios-root)',
  )
  .requiredOption('--coding-agent <name>', 'coding agent to run')
  .option('--coding-agents-dir <dir>', 'agents dir', 'coding-agents')
  .option('--out-root <dir>', 'results root', 'results')
  .option(
    '--scenarios-root <dir>',
    'root for a bare scenario name',
    'scenarios',
  )
  .action(async (scenario: string, opts: RunOptions) => {
    const scn = resolveScenarioDir(scenario, opts.scenariosRoot);
    if (scn === undefined) {
      process.stderr.write(
        `scenario not found: ${scenario} (looked at the path and under ${opts.scenariosRoot}/)\n`,
      );
      process.exit(2);
    }
    const { runDir, verdict } = await runScenario({
      scenarioDir: resolve(scn),
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
  .command('list')
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .action((opts: { scenariosRoot: string }) => {
    for (const name of scenarioNames(resolve(opts.scenariosRoot))) {
      process.stdout.write(`${name}\n`);
    }
    process.exit(0);
  });

program
  .command('new')
  .argument('<name>', 'scenario name')
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .action((name: string, opts: { scenariosRoot: string }) => {
    let scenarioDir: string;
    try {
      scenarioDir = newScenario(scenarioDirFor(name, opts.scenariosRoot));
    } catch (err: unknown) {
      if (err instanceof ScaffoldError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    process.stdout.write(`created ${scenarioDir}/\n`);
    process.stdout.write(
      '  story.md, setup.sh, checks.sh — fill in the TODOs\n',
    );
    process.exit(0);
  });

program
  .command('check')
  .argument('[names...]', 'scenario names (default: all)')
  .option('--fix', 'chmod +x scripts missing the bit', false)
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .action((names: string[], opts: { fix: boolean; scenariosRoot: string }) => {
    const root = opts.scenariosRoot;
    let targets: string[];
    if (names.length > 0) {
      // Each name resolves via the shared rule — a bare name or a path/prefixed
      // form (`foo` or `scenarios/foo`) both work, symmetric with `run`.
      targets = [];
      for (const name of names) {
        const dir = resolveScenarioDir(name, root);
        if (dir === undefined) {
          process.stderr.write(
            `error: no scenario '${name}' (looked at the path and under ${root}/)\n`,
          );
          process.exit(1);
        }
        targets.push(dir);
      }
    } else {
      targets = scenarioNames(resolve(root)).map((n) => join(resolve(root), n));
    }

    let failed = 0;
    for (const dir of targets) {
      if (opts.fix) {
        for (const fixed of fixExecutableBits(dir)) {
          process.stdout.write(`fixed +x ${basename(dir)}/${fixed}\n`);
        }
      }
      const problems = checkScenario(dir);
      if (problems.length > 0) {
        failed += 1;
        process.stdout.write(`FAIL ${basename(dir)}\n`);
        for (const problem of problems) {
          process.stdout.write(`  - ${problem}\n`);
        }
      } else {
        process.stdout.write(`ok   ${basename(dir)}\n`);
      }
    }
    if (failed > 0) {
      process.stderr.write(`\n${failed} scenario(s) failed validation\n`);
      process.exit(1);
    }
    process.exit(0);
  });

program
  .command('run-all')
  .option('--coding-agents <csv>', 'CSV agent filter (default: all)')
  .option('--scenarios <csv>', 'CSV scenario filter (default: all)')
  .option('--jobs <n>', 'global slot pool size (>=1)', String(DEFAULT_JOBS))
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .option('--coding-agents-dir <dir>', 'agents dir', 'coding-agents')
  .option('--out-root <dir>', 'results root', 'results')
  .option('--no-cursor', 'plain (append-only) output')
  .option('--tier <tier>', 'restrict to sentinel|full|adhoc')
  .option('--include-drafts', 'include status: draft scenarios', false)
  .action(async (opts: RunAllOptions) => {
    const agentFilter = csvList(opts.codingAgents);
    // Filter by scenario name; accept a path/prefixed form too (scenarios/foo
    // -> foo), symmetric with run/check.
    const scenarioFilter = csvList(opts.scenarios)?.map(scenarioName);
    const jobs = Number.parseInt(opts.jobs, 10);
    if (!Number.isInteger(jobs) || jobs < 1) {
      process.stderr.write('error: --jobs must be an integer >= 1\n');
      process.exit(1);
    }
    const { tier } = opts;
    if (
      tier !== undefined &&
      tier !== 'sentinel' &&
      tier !== 'full' &&
      tier !== 'adhoc'
    ) {
      process.stderr.write('error: --tier must be sentinel|full|adhoc\n');
      process.exit(1);
    }
    mkdirSync(resolve(opts.outRoot), { recursive: true });
    try {
      await runBatch({
        scenariosRoot: resolve(opts.scenariosRoot),
        codingAgentsDir: resolve(opts.codingAgentsDir),
        outRoot: resolve(opts.outRoot),
        jobs,
        ...(agentFilter !== undefined ? { agentFilter } : {}),
        ...(scenarioFilter !== undefined ? { scenarioFilter } : {}),
        tier: tier ?? null,
        includeDrafts: opts.includeDrafts,
        useCursor: opts.cursor,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      process.exit(1);
    }
    process.exit(0);
  });

program
  .command('show')
  .argument(
    '[target]',
    'run-dir, verdict.json, batch dir/id, or scenario prefix',
  )
  .option('-q, --quiet', 'final + reason only', false)
  .option('--json', 'raw verdict/batch json', false)
  .option('--no-color', 'disable color')
  .option('--results-root <dir>', 'results root', 'results')
  .action((target: string | undefined, opts: ShowOptions) => {
    // show is display-only and never carries a verdict's exit code: success is
    // always 0, resolution failure is 1, a malformed verdict is 2.
    if (opts.quiet && opts.json) {
      process.stderr.write('--quiet and --json are mutually exclusive\n');
      process.exit(1);
    }

    // resultsRoot is used as-given (default 'results', relative): the rendered
    // run-dir path mirrors it, matching the Python CLI byte-for-byte. resolve()
    // here would print an absolute run-dir and diverge from `uv run quorum show`.
    let runDir: string;
    try {
      runDir = resolveTarget(target, opts.resultsRoot);
    } catch (err: unknown) {
      if (err instanceof ShowError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    // A batch dir renders the scenario×agent matrix (or its raw json); the
    // matrix has no quiet mode (parity with the Python show).
    if (isBatchDir(runDir)) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(batchJson(runDir), null, 2)}\n`);
        process.exit(0);
      }
      process.stdout.write(
        renderBatch({
          batchDir: runDir,
          resultsRoot: opts.resultsRoot,
          color: opts.color && (process.stdout.isTTY ?? false),
        }),
      );
      process.exit(0);
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
