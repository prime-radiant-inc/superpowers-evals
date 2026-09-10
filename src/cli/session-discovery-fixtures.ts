import { basename, dirname, resolve } from 'node:path';
import { getEnv } from '../env.ts';
import {
  collectHistory,
  type DiscoveryHarness,
  installHistory,
} from '../experiments/session-discovery-fixtures.ts';

function requiredEnv(name: string): string {
  const value = getEnv(name);
  if (value === undefined || value === '') {
    throw new Error(`session-discovery-fixtures: ${name} is not set`);
  }
  return value;
}

function discoveryHarness(): DiscoveryHarness {
  const agent = requiredEnv('QUORUM_CODING_AGENT');
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'pi') {
    throw new Error(
      `session-discovery-fixtures: unsupported coding agent '${agent}'`,
    );
  }
  return agent;
}

function homeFromConfigDir(agent: DiscoveryHarness, configDir: string): string {
  const absolute = resolve(configDir);
  if (agent === 'pi') {
    if (
      basename(absolute) === 'agent' &&
      basename(dirname(absolute)) === '.pi'
    ) {
      return dirname(dirname(absolute));
    }
  } else if (basename(absolute) === `.${agent}`) {
    return dirname(absolute);
  }
  throw new Error(
    `session-discovery-fixtures: QUORUM_AGENT_CONFIG_DIR does not match ${agent}'s configured home subdirectory`,
  );
}

function usage(): number {
  process.stderr.write(
    'usage: session-discovery-fixtures install <source-dir>\n' +
      '       session-discovery-fixtures collect <source-dir> <output-dir>\n',
  );
  return 2;
}

export function main(argv: readonly string[]): number {
  const command = argv[0];
  if (
    (command === 'install' && argv.length !== 2) ||
    (command === 'collect' && argv.length !== 3) ||
    (command !== 'install' && command !== 'collect')
  ) {
    return usage();
  }

  try {
    const agent = discoveryHarness();
    const workdir = requiredEnv('QUORUM_WORKDIR');
    const sourceDir = argv[1] ?? '';
    if (command === 'install') {
      installHistory({
        agent,
        home: requiredEnv('QUORUM_CODING_AGENT_HOME'),
        workdir,
        sourceDir,
      });
    } else {
      collectHistory({
        agent,
        home: homeFromConfigDir(agent, requiredEnv('QUORUM_AGENT_CONFIG_DIR')),
        workdir,
        sourceDir,
        outputDir: argv[2] ?? '',
      });
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
