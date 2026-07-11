#!/usr/bin/env bun
import { Command } from 'commander';
import { executeRunCommand, type RunCommandOptions } from './run-command.ts';

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
  .action((scenario: string, opts: RunCommandOptions) =>
    executeRunCommand(scenario, opts, 'canonical-snapshot'),
  );

await program.parseAsync(process.argv);
