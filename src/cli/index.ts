#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { SpawnCommandRunner } from '../agents/command-runner.ts';
import {
  extractManifest,
  ManifestExtractionError,
  writeManifest,
} from '../check/manifest.ts';
import type { FinalVerdict } from '../contracts/verdict.ts';
import { FinalVerdictSchema } from '../contracts/verdict.ts';
import { checkCredentials } from '../credentials/check.ts';
import { getEnv } from '../env.ts';
import { exportRuns } from '../export-runs/index.ts';
import { runBatch } from '../run-all/index.ts';
import {
  configureRunAllOptions,
  type RunAllOptions,
} from '../run-all/options.ts';
import { writeGridManifest } from '../run-all/write-grid-manifest.ts';
import {
  checkScenario,
  fixExecutableBits,
  newScenario,
  ScaffoldError,
} from '../scaffold.ts';
import {
  type CampaignAcquireOptions,
  type CampaignEstimatesOptions,
  type CampaignSimulateOptions,
  campaignAcquire,
  campaignEstimates,
  campaignSimulate,
} from './campaign.ts';
import { costsJson, loadCostRows, renderCosts } from './costs.ts';
import type { ShowMode } from './render.ts';
import { render } from './render.ts';
import { batchJson, isBatchDir, renderBatch } from './render-batch.ts';
import { resolveTarget, ShowError } from './resolve-target.ts';
import { executeRunCommand, type RunCommandOptions } from './run-command.ts';
import {
  resolveScenarioDir,
  scenarioDirFor,
  scenarioName,
} from './scenario.ts';

function basename(path: string): string {
  const last = path.split('/').at(-1);
  return last !== undefined && last !== '' ? last : path;
}

// Fail fast (exit 1) when a scenarios-root does not exist or is not a directory,
// so a typo'd root on list/check is a hard error rather than a silent empty
// result.
function requireScenariosRoot(root: string): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`error: --scenarios-root does not exist: ${root}\n`);
    process.exit(1);
  }
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

// Strict integer parse for a numeric option: reject any non-integer token.
// Number.parseInt truncates (`3.5` -> 3, `8x` -> 8), so it can't gate the flag.
// Returns undefined for any token that is not a pure decimal integer (optionally
// signed).
function parseIntegerOption(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value)) {
    return undefined;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

// Parse a CSV filter flag: undefined/empty -> undefined (no filter, = all);
// otherwise the trimmed, non-empty members.
function csvList(csv: string | undefined): string[] | undefined {
  if (csv === undefined || csv === '') {
    return undefined;
  }
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  .argument(
    '<scenario>',
    'scenario dir or name (a bare name resolves under --scenarios-root)',
  )
  .requiredOption('--coding-agent <name>', 'coding agent to run')
  .option('--os <os>', 'target OS (linux|windows)', 'linux')
  .option('--coding-agents-dir <dir>', 'agents dir', 'coding-agents')
  .option('--out-root <dir>', 'results root', 'results')
  .option(
    '--scenarios-root <dir>',
    'root for a bare scenario name',
    'scenarios',
  )
  .option(
    '--credential <name>',
    'credential name (default: agent default_credential)',
  )
  .option('--credentials-file <path>', 'credentials YAML path')
  .option(
    '--grader-model <id>',
    'Gauntlet-Agent (grader) model (default: claude-sonnet-5)',
  )
  .action((scenario: string, opts: RunCommandOptions) =>
    executeRunCommand(
      scenario,
      opts,
      opts.credentialsFile === undefined ? undefined : 'external-campaign',
    ),
  );

program
  .command('list')
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .action((opts: { scenariosRoot: string }) => {
    const root = resolve(opts.scenariosRoot);
    requireScenariosRoot(root);
    for (const name of scenarioNames(root)) {
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
      scenarioDir = newScenario(scenarioDirFor(name, opts.scenariosRoot), name);
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
  .option(
    '--update-manifests',
    "write/refresh every scenario's checks-manifest.json, then validate",
    false,
  )
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .option('--credentials-file <path>', 'credentials YAML path')
  .option('--coding-agents-dir <dir>', 'coding-agents dir', 'coding-agents')
  .action(
    (
      names: string[],
      opts: {
        fix: boolean;
        updateManifests: boolean;
        scenariosRoot: string;
        credentialsFile?: string;
        codingAgentsDir: string;
      },
    ) => {
      const root = opts.scenariosRoot;
      // A missing --scenarios-root is a hard error before any scenario work, not a
      // silent empty run.
      requireScenariosRoot(resolve(root));
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
        targets = scenarioNames(resolve(root)).map((n) =>
          join(resolve(root), n),
        );
      }

      // Regenerate expected-check manifests before validation: the authoring
      // flow is edit checks.sh → quorum check --update-manifests → commit both
      // files. A scenario whose checks.sh cannot be extracted is reported here
      // and again (as a FAIL) by the validation pass below.
      if (opts.updateManifests) {
        for (const dir of targets) {
          if (!existsSync(join(dir, 'checks.sh'))) continue; // 'checks.sh missing' below
          try {
            writeManifest(dir, extractManifest(join(dir, 'checks.sh')));
          } catch (e) {
            if (e instanceof ManifestExtractionError) {
              process.stdout.write(
                `error: ${basename(dir)}: manifest extraction: ${e.message}\n`,
              );
              continue;
            }
            throw e;
          }
          process.stdout.write(`wrote ${basename(dir)}/checks-manifest.json\n`);
        }
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

      // Validate credentials.yaml against coding-agent default_credential fields.
      const credResult = checkCredentials(
        resolve(opts.credentialsFile ?? 'credentials.yaml'),
        resolve(opts.codingAgentsDir),
        {
          requireAgentDefaults: opts.credentialsFile === undefined,
          externalCampaign: opts.credentialsFile !== undefined,
        },
      );
      if (!credResult.ok) {
        failed += 1;
        process.stdout.write('FAIL credentials\n');
        for (const err of credResult.errors) {
          process.stdout.write(`  - ${err}\n`);
        }
      } else {
        process.stdout.write('ok   credentials\n');
      }

      if (failed > 0) {
        process.stderr.write(`\n${failed} check(s) failed validation\n`);
        process.exit(1);
      }
      process.exit(0);
    },
  );

configureRunAllOptions(program.command('run-all')).action(
  async (opts: RunAllOptions) => {
    const agentFilter = csvList(opts.codingAgents);
    // Filter by scenario name; accept a path/prefixed form too (scenarios/foo
    // -> foo), symmetric with run/check.
    const scenarioFilter = csvList(opts.scenarios)?.map(scenarioName);
    const credentialFilter = csvList(opts.credentials);
    const jobs = parseIntegerOption(opts.jobs);
    if (jobs === undefined || jobs < 1) {
      process.stderr.write('error: --jobs must be an integer >= 1\n');
      process.exit(1);
    }
    const heartbeatSeconds = parseIntegerOption(opts.heartbeatSeconds);
    if (heartbeatSeconds === undefined || heartbeatSeconds < 0) {
      process.stderr.write(
        'error: --heartbeat-seconds must be an integer >= 0\n',
      );
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
    // Validate the input roots exist at the CLI boundary: a typo'd root fails
    // fast here rather than depending on runBatch's internal directory walk.
    for (const [flag, dir] of [
      ['--scenarios-root', opts.scenariosRoot],
      ['--coding-agents-dir', opts.codingAgentsDir],
    ] as const) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        process.stderr.write(`error: ${flag} does not exist: ${dir}\n`);
        process.exit(1);
      }
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
        ...(credentialFilter !== undefined ? { credentialFilter } : {}),
        ...(opts.credentialsFile !== undefined
          ? { credentialsPath: resolve(opts.credentialsFile) }
          : {}),
        tier: tier ?? null,
        includeDrafts: opts.includeDrafts,
        heartbeatSeconds,
        ...(opts.graderModel !== undefined
          ? { graderModel: opts.graderModel }
          : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      process.exit(1);
    }
    process.exit(0);
  },
);

interface GridManifestOptions {
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly out: string;
}

program
  .command('grid-manifest')
  .description('emit grid-manifest.json (scenario × agent × os eligibility)')
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .option('--coding-agents-dir <dir>', 'agents dir', 'coding-agents')
  .option('--out <path>', 'output path', 'results/grid-manifest.json')
  .action((opts: GridManifestOptions) => {
    const outPath = resolve(opts.out);
    writeGridManifest({
      scenariosRoot: resolve(opts.scenariosRoot),
      codingAgentsDir: resolve(opts.codingAgentsDir),
      outPath,
      now: new Date().toISOString(),
    });
    process.stdout.write(`grid-manifest written to ${outPath}\n`);
    process.exit(0);
  });

interface ExportRunsOptions {
  readonly out: string;
  readonly superpowersRepo: string | undefined;
}

program
  .command('export-runs')
  .description(
    'build a scrubbed bundle of local runs for evals-appliance import',
  )
  .argument('<results-dir>', 'local results dir to export')
  .requiredOption('--out <dir>', 'bundle output dir')
  .option(
    '--superpowers-repo <path>',
    'superpowers checkout used to resolve archived skill trees to commits',
  )
  .action((resultsDir: string, opts: ExportRunsOptions) => {
    const source = resolve(resultsDir);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      process.stderr.write(`error: results dir does not exist: ${source}\n`);
      process.exit(1);
    }
    // Without a repo the tree hash is still recorded, so runs degrade to
    // tree_only rather than failing the export.
    const superpowersRepo = resolve(
      opts.superpowersRepo ?? getEnv('SUPERPOWERS_ROOT') ?? '.',
    );

    let last = 0;
    const summary = exportRuns({
      resultsDir: source,
      outDir: resolve(opts.out),
      superpowersRepo,
      runner: new SpawnCommandRunner(),
      sourceHost: hostname(),
      now: new Date().toISOString(),
      onProgress: (done, total) => {
        // One line per 25 runs keeps a 626-run export legible.
        if (done === total || done - last >= 25) {
          last = done;
          process.stderr.write(`  exported ${done}/${total}\n`);
        }
      },
    });

    const recovery = Object.entries(summary.byRecovery)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${status}=${count}`)
      .join(' ');
    process.stdout.write(
      `bundle written to ${summary.bundleDir}\n` +
        `  exported ${summary.exported}, skipped ${summary.skipped}\n` +
        `  superpowers rev: ${recovery}\n`,
    );
    process.exit(0);
  });

const campaign = program
  .command('campaign')
  .description('campaign platform (Phase 0: corpus, estimates, simulation)');
campaign
  .command('acquire')
  .description('pull a run-ID-selected corpus (runs on the appliance)')
  .requiredOption('--runs-file <path>', 'newline-delimited run IDs')
  .requiredOption('--results-root <dir>', 'results root to read')
  .requiredOption('--out <dir>', 'corpus output dir')
  .action((opts: CampaignAcquireOptions) => campaignAcquire(opts));
campaign
  .command('estimates')
  .description(
    'build quorum.estimates/v1 from a corpus (+ optional local inclusion)',
  )
  .option(
    '--corpus <dir>',
    'corpus dir (required unless --scan-results is used alone)',
  )
  .option(
    '--manifest <path>',
    'replay manifest (required unless --scan-results is used alone)',
  )
  .option('--scan-results <dir>', 'print a local-results inclusion manifest')
  .option('--inclusion <path>', 'consume a committed inclusion manifest')
  .option(
    '--out <path>',
    'artifact output path (required unless --scan-results is used alone)',
  )
  .action((opts: CampaignEstimatesOptions) => campaignEstimates(opts));
campaign
  .command('simulate')
  .description('replay the corpus through the campaign dispatch policy')
  .requiredOption('--corpus <dir>', 'corpus dir')
  .requiredOption('--manifest <path>', 'replay manifest')
  .requiredOption('--estimates <path>', 'estimates artifact')
  .option(
    '--sweep <name>',
    'sweep preset: default|oracle|grader-active (defaults to default)',
  )
  .option('--config <json>', 'single explicit configuration')
  .option(
    '--pool-identity <target|legacy>',
    'pool identity (valid only with --config; default target)',
  )
  .option('--ordering <mode>', 'ordering override')
  .option('--grader-occupancy <mode>', 'grader occupancy override')
  .option('--seal-allowance-min <n>', 'seal/report allowance minutes', '15')
  .requiredOption('--out <dir>', 'output dir')
  .action((opts: CampaignSimulateOptions) => campaignSimulate(opts));

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
    // run-dir path mirrors it. resolve() here would print an absolute run-dir
    // and change the displayed path.
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
    // matrix has no quiet mode.
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

    // --json never schema-validates (parse -> re-serialize): a parseable-but-
    // off-schema verdict is dumped verbatim, and unknown top-level keys survive.
    // Only unparseable JSON exits 2.
    if (opts.json) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8'));
      } catch {
        process.stderr.write('malformed verdict.json\n');
        process.exit(2);
      }
      process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
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

    const mode: ShowMode = opts.quiet ? 'quiet' : 'full';
    process.stdout.write(
      render(verdict, runDir, {
        color: opts.color && (process.stdout.isTTY ?? false),
        mode,
      }),
    );
    process.exit(0);
  });

interface CostsOptions {
  readonly json: boolean;
  readonly withGauntlet: boolean;
  readonly color: boolean;
  readonly resultsRoot: string;
}

program
  .command('costs')
  .description(
    'coding-agent cost/token/runtime report for a run or a batch (the gauntlet QA-driver side is opt-in via --with-gauntlet)',
  )
  .argument(
    '[target]',
    'run-dir, verdict.json, batch dir/id, or scenario prefix (default: newest run)',
  )
  .option('--json', 'machine-readable rows + aggregate', false)
  .option('--with-gauntlet', 'also show the QA-driver (gauntlet) cost', false)
  .option('--no-color', 'disable color')
  .option('--results-root <dir>', 'results root', 'results')
  .action((target: string | undefined, opts: CostsOptions) => {
    // costs is display-only: success is 0, an unresolvable target is 1. A
    // missing/partial economics block is NOT an error — it renders as
    // "unpriced" (parity with how show degrades a malformed economics pane).
    let rows: ReturnType<typeof loadCostRows>;
    try {
      rows = loadCostRows(target, opts.resultsRoot);
    } catch (err: unknown) {
      if (err instanceof ShowError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(costsJson(rows), null, 2)}\n`);
      process.exit(0);
    }

    process.stdout.write(
      renderCosts(rows, {
        color: opts.color && (process.stdout.isTTY ?? false),
        withGauntlet: opts.withGauntlet,
      }),
    );
    process.exit(0);
  });

await program.parseAsync(process.argv);
