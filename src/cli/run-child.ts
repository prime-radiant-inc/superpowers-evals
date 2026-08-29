#!/usr/bin/env bun
import { Command, Option } from 'commander';
import {
  executeRunCommand,
  normalizeRunCommandOptions,
  type RunCommandOptions,
} from './run-command.ts';

const program = new Command();
program
  .name('quorum-run-child')
  .description('Internal run-all child')
  .argument('<scenario>')
  .requiredOption('--coding-agent <name>')
  .option('--os <os>', 'target OS', 'linux')
  .requiredOption('--coding-agents-dir <dir>')
  .requiredOption('--out-root <dir>')
  .option('--scenarios-root <dir>', 'scenario root', 'scenarios')
  .option('--credential <name>')
  .requiredOption('--credentials-file <path>')
  .option('--grader-model <id>')
  .option('--gauntlet-bin <path>')
  .option(
    '--campaign-identity <json>',
    'campaign identity block (campaign children)',
  )
  .addOption(
    // The conflicts target is the negated flag's derived option name —
    // commander parses `--no-superpowers` as `superpowers`, not
    // `noSuperpowers`.
    new Option(
      '--superpowers-root <path>',
      'explicit superpowers root (campaign child runs)',
    ).conflicts('superpowers'),
  )
  .option('--no-superpowers', 'run stock — suppress all superpowers staging')
  .action(
    async (
      scenario: string,
      opts: RunCommandOptions & { superpowers?: boolean },
    ) => {
      process.exit(
        await executeRunCommand(
          scenario,
          normalizeRunCommandOptions(opts),
          'canonical-snapshot',
        ),
      );
    },
  );

await program.parseAsync(process.argv);
