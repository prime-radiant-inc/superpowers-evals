import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { getEnv } from '../env.ts';
import {
  type DiagnosisHarness,
  type FixtureManifest,
  FixtureManifestSchema,
} from '../experiments/diagnosis/contracts.ts';
import {
  installDiagnosisFixture,
  verifyDiagnosisFixture,
} from '../experiments/diagnosis/fixtures.ts';

function requiredEnv(name: string): string {
  const value = getEnv(name);
  if (value === undefined || value === '') {
    throw new Error(`diagnosis-fixtures: ${name} is not set`);
  }
  return value;
}

function loadManifest(path: string): FixtureManifest {
  return FixtureManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function homeFromConfigDir(
  harness: DiagnosisHarness,
  configDir: string,
): string {
  const absolute = resolve(configDir);
  if (
    harness === 'pi' &&
    basename(absolute) === 'agent' &&
    basename(dirname(absolute)) === '.pi'
  ) {
    return dirname(dirname(absolute));
  }
  if (harness !== 'pi' && basename(absolute) === `.${harness}`) {
    return dirname(absolute);
  }
  throw new Error(
    `diagnosis-fixtures: QUORUM_AGENT_CONFIG_DIR does not match ${harness}'s configured home subdirectory`,
  );
}

function usage(): number {
  process.stderr.write(
    'usage: diagnosis-fixtures install <manifest> <corpus-dir>\n' +
      '       diagnosis-fixtures verify <manifest> <corpus-dir>\n',
  );
  return 2;
}

export function main(argv: readonly string[]): number {
  const command = argv[0];
  if (argv.length !== 3 || (command !== 'install' && command !== 'verify')) {
    return usage();
  }

  try {
    const manifest = loadManifest(argv[1] ?? '');
    const corpusDir = argv[2] ?? '';
    const workdir = requiredEnv('QUORUM_WORKDIR');
    if (command === 'install') {
      installDiagnosisFixture({
        manifest,
        corpusDir,
        home: requiredEnv('QUORUM_CODING_AGENT_HOME'),
        workdir,
      });
      return 0;
    }

    const rows = verifyDiagnosisFixture({
      manifest,
      corpusDir,
      home: homeFromConfigDir(
        manifest.harness,
        requiredEnv('QUORUM_AGENT_CONFIG_DIR'),
      ),
      workdir,
    });
    return rows.every((row) => row.status === 'unchanged') ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 127;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
