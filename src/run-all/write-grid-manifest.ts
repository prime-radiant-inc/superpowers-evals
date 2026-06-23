import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildGridManifest } from './matrix.ts';

export function writeGridManifest(args: {
  scenariosRoot: string;
  codingAgentsDir: string;
  outPath: string;
  now: string;
}): void {
  const manifest = buildGridManifest(
    {
      scenariosRoot: args.scenariosRoot,
      codingAgentsDir: args.codingAgentsDir,
    },
    args.now,
  );
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
